import { db } from "../firebase.js";

// ─────────────────────────────────────────────
// DATA FETCHERS — ORIGINAL THREE
// ─────────────────────────────────────────────

async function fetchKp(since) {
  const url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
  const res = await fetch(url);
  const raw = await res.json();

  const rows = raw.slice(1);
  const sinceTime = since ? new Date(since) : new Date(Date.now() - 86400000);

  const readings = rows
    .filter(r => new Date(r[0]) > sinceTime)
    .map(r => ({
      time: r[0],
      kp: parseFloat(r[1])
    }));

  // Return baseline stats even when quiet — don't drop the feed on calm days
  if (readings.length === 0) {
    return {
      feed: "kp_geomagnetic",
      stats: {
        readings_captured: 0,
        peak_kp: 0,
        average_kp: 0,
        storm_level_readings: 0,
        status: "QUIET"
      },
      anomalies: []
    };
  }

  const values = readings.map(r => r.kp);
  const peak = Math.max(...values);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const stormReadings = readings.filter(r => r.kp >= 5);
  // Flag elevated Kp (>=4) as moderate anomaly even below storm threshold
  const elevatedReadings = readings.filter(r => r.kp >= 4 && r.kp < 5);

  const anomalies = [
    ...stormReadings.map(r => ({
      source: "kp_geomagnetic",
      time: r.time,
      value: r.kp,
      label: `Geomagnetic storm — Kp ${r.kp}`,
      severity: r.kp >= 7 ? "extreme" : r.kp >= 6 ? "major" : "significant",
      lat: null,
      lng: null,
      anomaly_score: Math.min(10, (r.kp / 9) * 10)
    })),
    ...elevatedReadings.map(r => ({
      source: "kp_geomagnetic",
      time: r.time,
      value: r.kp,
      label: `Geomagnetic activity elevated — Kp ${r.kp}`,
      severity: "moderate",
      lat: null,
      lng: null,
      anomaly_score: Math.min(10, (r.kp / 9) * 10)
    }))
  ];

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
  if (events.length === 0) return {
    feed: "usgs_seismic",
    stats: {
      total_events: 0,
      above_m3: 0,
      above_m5: 0,
      above_m6: 0,
      peak_magnitude: 0,
      average_magnitude: 0,
      status: "QUIET"
    },
    anomalies: []
  };

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
// DATA FETCHERS — NEW FEEDS (v2.4 GPDM)
// ─────────────────────────────────────────────

// NOAA DSCOVR real-time solar wind — Variable 1 early warning
// 30-60 minutes ahead of Kp spike. Speed >600 km/s = storm incoming.
async function fetchSolarWind() {
  try {
    const [magRes, plasmaRes] = await Promise.all([
      fetch("https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json"),
      fetch("https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json")
    ]);

    const magRaw = await magRes.json();
    const plasmaRaw = await plasmaRes.json();

    // Last 2 hours of data — most recent readings
    const recentMag = magRaw.slice(-24);
    const recentPlasma = plasmaRaw.slice(-24);

    const latestMag = recentMag[recentMag.length - 1];
    const latestPlasma = recentPlasma[recentPlasma.length - 1];

    // Bt = total field strength, Bz = north/south component (negative = geoeffective)
    const bt = parseFloat(latestMag[6]);
    const bz = parseFloat(latestMag[3]);
    const speed = parseFloat(latestPlasma[2]);
    const density = parseFloat(latestPlasma[1]);

    // Elevated thresholds — GPDM Variable 1 relevance
    const isElevated = speed > 500 || density > 15 || bz < -10;
    const isStormWarning = speed > 600 || bz < -15;

    const anomalies = isStormWarning ? [{
      source: "solar_wind",
      time: new Date().toISOString(),
      value: speed,
      label: `Solar wind elevated — ${speed.toFixed(0)} km/s, Bz ${bz.toFixed(1)} nT`,
      severity: bz < -20 ? "extreme" : "major",
      lat: null,
      lng: null,
      anomaly_score: Math.min(10, (speed / 800) * 10)
    }] : [];

    return {
      feed: "solar_wind",
      stats: {
        speed_kms: parseFloat(speed.toFixed(1)),
        density_pcm3: parseFloat(density.toFixed(2)),
        bt_nT: parseFloat(bt.toFixed(2)),
        bz_nT: parseFloat(bz.toFixed(2)),
        geoeffective: bz < -5,
        status: isStormWarning ? "STORM WARNING — Kp spike likely 30-60 min"
               : isElevated ? "ELEVATED — monitor Kp"
               : "NOMINAL"
      },
      anomalies
    };
  } catch (e) {
    return null;
  }
}

// NOAA F10.7 Solar Flux — daily Variable 1 long-range indicator
// Fred Pallesen correlation target — Hessdalen AMS timestamps vs F10.7
async function fetchF107() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/products/summary/10cm-flux.json");
    const raw = await res.json();

    const flux = parseFloat(raw.Flux);
    const isElevated = flux > 150;
    const isHigh = flux > 200;

    const anomalies = isHigh ? [{
      source: "f107_solar_flux",
      time: new Date().toISOString(),
      value: flux,
      label: `F10.7 solar flux elevated — ${flux} sfu`,
      severity: flux > 250 ? "extreme" : "moderate",
      lat: null,
      lng: null,
      anomaly_score: Math.min(10, (flux / 300) * 10)
    }] : [];

    return {
      feed: "f107_solar_flux",
      stats: {
        flux_sfu: flux,
        status: isHigh ? "HIGH SOLAR ACTIVITY"
               : isElevated ? "ELEVATED SOLAR ACTIVITY"
               : "NORMAL",
        gpdm_note: "F10.7 > 150 correlates with elevated geological discharge probability at GPDM sites"
      },
      anomalies
    };
  } catch (e) {
    return null;
  }
}

// GOES X-ray Flux — real-time solar flare detection
// Solar flare → ionospheric TEC disturbance → GPS degradation → Variable 1 cascade
async function fetchGoesXray() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json");
    const raw = await res.json();

    if (!raw || raw.length === 0) return null;

    // Last 30 minutes of readings
    const recent = raw.slice(-30);
    const latest = recent[recent.length - 1];
    const flux = parseFloat(latest.flux);
    const time = latest.time_tag;

    // GOES X-ray classification thresholds
    // B < 1e-6, C 1e-6 to 1e-5, M 1e-5 to 1e-4, X > 1e-4
    const getClass = (f) => {
      if (f >= 1e-4) return "X";
      if (f >= 1e-5) return "M";
      if (f >= 1e-6) return "C";
      return "B";
    };

    const flareClass = getClass(flux);
    const isMOrHigher = flux >= 1e-5;
    const isXClass = flux >= 1e-4;

    const peakFlux = Math.max(...recent.map(r => parseFloat(r.flux)));
    const peakClass = getClass(peakFlux);

    const anomalies = isMOrHigher ? [{
      source: "goes_xray",
      time,
      value: flareClass,
      label: `${flareClass}-class solar flare detected`,
      severity: isXClass ? "extreme" : "major",
      lat: null,
      lng: null,
      anomaly_score: isXClass ? 9 : 7
    }] : [];

    return {
      feed: "goes_xray",
      stats: {
        current_flux: flux.toExponential(2),
        current_class: flareClass,
        peak_class_24h: peakClass,
        status: isXClass ? "X-CLASS FLARE — ionospheric blackout possible"
               : isMOrHigher ? "M-CLASS FLARE — elevated ionospheric disturbance"
               : `BACKGROUND — Class ${flareClass}`,
        gpdm_note: "M/X flares drive ionospheric TEC anomalies — GPS SNR degradation expected 1-24 hours"
      },
      anomalies
    };
  } catch (e) {
    return null;
  }
}

// Schumann Resonance status — GPDM dual falsifiable prediction channel
// 3rd/4th mode anomaly = 1-7 day pre-event window in GPDM predictive function
// Tomsk station publishes image data — we proxy the activity status via
// HeartMath GCI power index which provides hourly JSON-accessible data
async function fetchSchumann() {
  try {
    // NOAA Dst index as Schumann proxy — geomagnetic disturbance drives SR amplitude
    // When Dst drops (ring current injection during storm) SR power increases
    const res = await fetch("https://services.swpc.noaa.gov/products/kyoto-dst.json");
    const raw = await res.json();

    const rows = raw.slice(1); // skip header
    const recent = rows.slice(-12); // last 12 hours
    const values = recent.map(r => parseFloat(r[1])).filter(v => !isNaN(v));

    if (values.length === 0) return null;

    const latestDst = values[values.length - 1];
    const minDst = Math.min(...values);

    // Dst < -30 = moderate disturbance, correlates with elevated SR amplitude
    // Dst < -100 = major storm, SR 3rd/4th mode anomaly expected
    const isElevated = minDst < -30;
    const isMajor = minDst < -100;

    const anomalies = isMajor ? [{
      source: "schumann_proxy",
      time: new Date().toISOString(),
      value: minDst,
      label: `Schumann resonance disturbance — Dst ${minDst} nT`,
      severity: minDst < -200 ? "extreme" : "major",
      lat: null,
      lng: null,
      anomaly_score: Math.min(10, Math.abs(minDst) / 30)
    }] : [];

    return {
      feed: "schumann_proxy",
      stats: {
        dst_nT: latestDst,
        min_dst_12h: minDst,
        sr_disturbance_likely: isElevated,
        status: isMajor ? "MAJOR SR DISTURBANCE — 3rd/4th mode anomaly likely"
               : isElevated ? "ELEVATED — SR amplitude above baseline"
               : "NOMINAL",
        gpdm_note: "GPDM predicts Schumann 3rd/4th mode anomaly 1-7 days before discharge events. Dst proxy used pending direct SR feed integration."
      },
      anomalies
    };
  } catch (e) {
    return null;
  }
}

// Ionospheric TEC proxy — GPS Total Electron Content disturbance
// Pre-seismic TEC anomaly documented 1-15 days before M6+ events
// Using NOAA SWPC ionospheric data as proxy
async function fetchIonosphere() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json");
    const raw = await res.json();

    // Bz drives ionospheric currents — southward Bz causes TEC enhancement
    const bz = parseFloat(raw.Bz);
    const bt = parseFloat(raw.Bt);

    // Strong southward Bz drives ionospheric TEC enhancement
    const isTECElevated = bz < -10 && bt > 10;
    const isTECMajor = bz < -20;

    const anomalies = isTECMajor ? [{
      source: "ionosphere_tec",
      time: new Date().toISOString(),
      value: bz,
      label: `Ionospheric TEC disturbance — Bz ${bz.toFixed(1)} nT southward`,
      severity: bz < -25 ? "extreme" : "major",
      lat: null,
      lng: null,
      anomaly_score: Math.min(10, Math.abs(bz) / 3)
    }] : [];

    return {
      feed: "ionosphere_tec",
      stats: {
        bz_nT: parseFloat(bz.toFixed(2)),
        bt_nT: parseFloat(bt.toFixed(2)),
        tec_disturbance: isTECElevated,
        status: isTECMajor ? "MAJOR TEC DISTURBANCE — GPS degradation expected"
               : isTECElevated ? "TEC ELEVATED — monitor GPS SNR"
               : "NOMINAL",
        gpdm_note: "TEC anomalies 1-15 days before M6+ events documented by Hayakawa et al. GPS SNR proxy in field node measures same layer from ground."
      },
      anomalies
    };
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// CROSS-CHANNEL ANALYSIS — EXPANDED
// ─────────────────────────────────────────────

function analyzeCrossChannel(feeds) {
  const activeFeeds = feeds.filter(f => f && f.anomalies.length > 0);
  const isMultiChannel = activeFeeds.length >= 2;

  const flags = [];
  if (isMultiChannel) {
    flags.push(`Multi-channel event: ${activeFeeds.map(f => f.feed).join(" + ")}`);
  }

  // Original correlation
  const hasSolar = activeFeeds.find(f => f.feed === "donki_solar");
  const hasKp = activeFeeds.find(f => f.feed === "kp_geomagnetic");
  if (hasSolar && hasKp) {
    flags.push("Solar activity correlating with geomagnetic disturbance — causal chain possible");
  }

  // New GPDM-specific correlations
  const hasSolarWind = activeFeeds.find(f => f.feed === "solar_wind");
  const hasGoesXray = activeFeeds.find(f => f.feed === "goes_xray");
  const hasSchumann = activeFeeds.find(f => f.feed === "schumann_proxy");
  const hasSeismic = activeFeeds.find(f => f.feed === "usgs_seismic");
  const hasTEC = activeFeeds.find(f => f.feed === "ionosphere_tec");

  // GPDM Variable 1 cascade — solar wind → Kp → geological discharge window
  if (hasSolarWind && hasKp) {
    flags.push("GPDM V1 CASCADE: Solar wind elevated correlating with Kp — geological discharge window open at active sites");
  }

  // CME chain — the full GPDM Pathway 6 solar trigger
  if (hasSolar && hasSolarWind && hasKp) {
    flags.push("GPDM CME CHAIN: Flare → solar wind → geomagnetic disturbance — complete Variable 1 chain active. Pathway 6 water table coupling possible at GPDM sites.");
  }

  // Ionospheric + seismic — pre-seismic TEC correlation window
  if (hasTEC && hasSeismic) {
    flags.push("GPDM PRECURSOR: Ionospheric disturbance correlating with seismic activity — TEC pre-seismic window possible");
  }

  // Schumann + geomagnetic — GPDM dual prediction channel
  if (hasSchumann && hasKp) {
    flags.push("GPDM PREDICTION CHANNEL: Schumann disturbance + geomagnetic storm — monitor for 1-7 day discharge window at active GPDM sites");
  }

  // X-ray + TEC — ionospheric cascade
  if (hasGoesXray && hasTEC) {
    flags.push("Solar flare driving ionospheric TEC disturbance — GPS SNR degradation expected at field nodes");
  }

  // Full planetary chain active
  const chainFeeds = [hasGoesXray, hasSolarWind, hasKp, hasTEC, hasSchumann].filter(Boolean);
  if (chainFeeds.length >= 4) {
    flags.push("GPDM PLANETARY CHAIN: Multiple layers of the Sun-to-ground circuit active simultaneously — elevated discharge probability at all qualified GPDM sites");
  }

  return {
    multi_channel: isMultiChannel,
    active_feed_count: activeFeeds.length,
    flags
  };
}

// ─────────────────────────────────────────────
// NASA OMNI — MULTI-VARIABLE SOLAR WIND HISTORICAL
// Variable 1 multi-condition assessment
// Historical depth back to 1963
// ─────────────────────────────────────────────

async function fetchOMNI() {
  try {
    const now = new Date();
    const yesterday = new Date(now - 86400000);
    const startDate = yesterday.toISOString().slice(0,10).replace(/-/g,'');
    const endDate = now.toISOString().slice(0,10).replace(/-/g,'');

    const params = new URLSearchParams({
      activity: 'retrieve',
      res: 'hour',
      spacecraft: 'omni2',
      start_date: startDate,
      end_date: endDate,
      table: '1',
      view: '0'
    });
    ['8','13','23','24','40','38','50'].forEach(v => params.append('vars', v));

    const res = await fetch('https://omniweb.gsfc.nasa.gov/cgi/nx1.cgi', {
      method: 'POST',
      body: params
    });

    const text = await res.text();
    const lines = text.split('\n').filter(l => /^\s*\d{4}\s+\d+/.test(l));
    if (lines.length === 0) return null;

    const readings = lines.map(line => {
      const p = line.trim().split(/\s+/);
      return {
        bt: parseFloat(p[3]),
        bz: parseFloat(p[4]),
        speed: parseFloat(p[5]),
        density: parseFloat(p[6]),
        kp: parseFloat(p[7]) / 10,
        f107: parseFloat(p[8]),
        dst: parseFloat(p[9])
      };
    }).filter(r => r.speed < 9000 && r.bt < 9000 && r.bz < 9000 && r.density < 9000);

    if (readings.length === 0) return null;

    const avgSpeed = readings.reduce((a,b) => a + b.speed, 0) / readings.length;
    const minBz = Math.min(...readings.map(r => r.bz));
    const maxDensity = Math.max(...readings.map(r => r.density));
    const dstValues = readings.map(r => r.dst).filter(d => d > -9000);
    const minDst = dstValues.length > 0 ? Math.min(...dstValues) : null;
    const latestF107 = readings.filter(r => r.f107 < 9000).pop()?.f107 || null;

    const activeConditions = [
      avgSpeed > 500 && 'elevated solar wind speed',
      minBz < -10 && 'southward Bz geoeffective',
      maxDensity > 15 && 'high proton density',
      minDst !== null && minDst < -30 && 'geomagnetic disturbance (Dst suppressed)',
      latestF107 && latestF107 > 150 && 'elevated solar flux'
    ].filter(Boolean);

    return {
      feed: "omni_solar_wind",
      stats: {
        avg_speed_kms: parseFloat(avgSpeed.toFixed(1)),
        min_bz_nT: parseFloat(minBz.toFixed(2)),
        max_density: parseFloat(maxDensity.toFixed(2)),
        min_dst_nT: minDst,
        f107_sfu: latestF107,
        active_conditions: activeConditions.length,
        status: activeConditions.length >= 3 ? "MULTI-CONDITION ALERT — V1 cascade likely"
               : activeConditions.length >= 2 ? "ELEVATED — multiple V1 conditions active"
               : activeConditions.length === 1 ? "WATCH — single V1 condition elevated"
               : "NOMINAL",
        gpdm_note: "OMNI multi-variable assessment for GPDM Variable 1 (stress rate) composite scoring"
      },
      anomalies: activeConditions.length >= 2 ? [{
        source: "omni_solar_wind",
        time: new Date().toISOString(),
        value: activeConditions.length,
        label: `OMNI multi-condition: ${activeConditions.join(', ')}`,
        severity: activeConditions.length >= 3 ? "major" : "moderate",
        lat: null, lng: null,
        anomaly_score: Math.min(10, activeConditions.length * 2.5)
      }] : []
    };
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// REAL DST INDEX — Kyoto World Data Centre
// Direct ring current disturbance measurement
// More reliable than OMNI Dst proxy
// ─────────────────────────────────────────────

async function fetchDst() {
  try {
    // Primary: NOAA Kyoto Dst real-time feed
    const res = await fetch("https://services.swpc.noaa.gov/products/kyoto-dst.json");
    const raw = await res.json();

    const rows = raw.slice(1);
    const recent = rows.slice(-24); // last 24 hours
    const values = recent
      .map(r => parseFloat(r[1]))
      .filter(v => !isNaN(v) && v > -9999);

    if (values.length === 0) return null;

    const latestDst = values[values.length - 1];
    const minDst = Math.min(...values);
    const avgDst = parseFloat((values.reduce((a,b) => a+b, 0) / values.length).toFixed(1));

    // Dst thresholds:
    // 0 to -20 = quiet
    // -20 to -50 = minor storm
    // -50 to -100 = moderate storm
    // -100 to -200 = intense storm
    // < -200 = super storm
    const getStormLevel = (d) => {
      if (d > -20) return "QUIET";
      if (d > -50) return "MINOR STORM";
      if (d > -100) return "MODERATE STORM";
      if (d > -200) return "INTENSE STORM";
      return "SUPER STORM";
    };

    const stormLevel = getStormLevel(minDst);
    const isElevated = minDst < -30;
    const isStorm = minDst < -50;

    const anomalies = isStorm ? [{
      source: "dst_index",
      time: new Date().toISOString(),
      value: minDst,
      label: `Dst ${stormLevel} — ${minDst} nT (ring current injection)`,
      severity: minDst < -200 ? "extreme" : minDst < -100 ? "major" : "significant",
      lat: null, lng: null,
      anomaly_score: Math.min(10, Math.abs(minDst) / 25)
    }] : [];

    return {
      feed: "dst_index",
      stats: {
        dst_latest_nT: latestDst,
        dst_min_24h_nT: minDst,
        dst_avg_24h_nT: avgDst,
        storm_level: stormLevel,
        ring_current_active: isElevated,
        status: stormLevel,
        gpdm_note: "Dst suppression below -50 nT indicates ring current injection — GPDM V3 atmospheric state disturbance. Schumann SR amplitude correlates with ring current strength."
      },
      anomalies
    };
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// NMDB COSMIC RAY NEUTRON FLUX
// Oulu station — longest continuous cosmic ray record
// Directly links The Traveling System paper to dashboard
// Cosmic ray modulation = ISM density + heliospheric boundary
// Pre-seismic cosmic ray decreases documented (Forbush decrease)
// ─────────────────────────────────────────────

async function fetchCosmicRay() {
  try {
    // NMDB Oulu neutron monitor — REST API
    // Oulu Finland station — 60+ year continuous record
    const now = new Date();
    const yesterday = new Date(now - 86400000);
    const fmt = d => d.toISOString().slice(0,16).replace('T',' ');

    const url = `https://www.nmdb.eu/nest/draw_graph.php?formchk=1&stations[]=OULU&tabchoice=1hr&dtype=corr_for_efficiency&tresolution=60&force=1&s_date1=${fmt(yesterday)}&s_time1=00:00&s_date2=${fmt(now)}&s_time2=23:59&output=ascii`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Presignal-AnomalyDashboard/2.0 (jubecrew@gmail.com)' }
    });
    const text = await res.text();

    // Parse ASCII output — lines like: 2026-05-06 14:00:00  1234.5
    const lines = text.split('\n').filter(l => /^\d{4}-\d{2}-\d{2}/.test(l.trim()));

    if (lines.length === 0) return null;

    const readings = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      return {
        time: `${parts[0]}T${parts[1]}Z`,
        count: parseFloat(parts[2])
      };
    }).filter(r => !isNaN(r.count) && r.count > 0);

    if (readings.length === 0) return null;

    const counts = readings.map(r => r.count);
    const latest = counts[counts.length - 1];
    const avg = counts.reduce((a,b) => a+b, 0) / counts.length;
    const min = Math.min(...counts);
    const max = Math.max(...counts);

    // Forbush decrease: >3% drop from mean = significant solar modulation
    // Pre-seismic anomaly: >1% anomaly from baseline
    const pctFromMean = parseFloat(((latest - avg) / avg * 100).toFixed(2));
    const minPctDrop = parseFloat(((min - avg) / avg * 100).toFixed(2));

    const isForbush = minPctDrop < -3;
    const isAnomaly = Math.abs(pctFromMean) > 1;

    const anomalies = isForbush ? [{
      source: "cosmic_ray_nmdb",
      time: new Date().toISOString(),
      value: minPctDrop,
      label: `Forbush decrease detected — cosmic ray flux ${Math.abs(minPctDrop).toFixed(1)}% below mean`,
      severity: minPctDrop < -10 ? "major" : "significant",
      lat: null, lng: null,
      anomaly_score: Math.min(10, Math.abs(minPctDrop) / 2)
    }] : [];

    return {
      feed: "cosmic_ray_nmdb",
      stats: {
        latest_count: parseFloat(latest.toFixed(1)),
        avg_count_24h: parseFloat(avg.toFixed(1)),
        pct_from_mean: pctFromMean,
        min_pct_drop_24h: minPctDrop,
        forbush_decrease: isForbush,
        station: "OULU — Finland (60°N)",
        status: isForbush ? "FORBUSH DECREASE — solar modulation active"
               : isAnomaly ? "ANOMALY — cosmic ray flux deviation detected"
               : "NOMINAL — galactic cosmic ray baseline stable",
        gpdm_note: "Cosmic ray flux connects The Traveling System (heliospheric modulation of GCR) to GPDM Variable 1. Forbush decreases 1-3 days after CME arrival. Pre-seismic GCR anomalies documented by Kovalyov et al."
      },
      anomalies
    };
  } catch (e) {
    // Fallback: try alternative NMDB endpoint
    try {
      const res2 = await fetch("https://www.nmdb.eu/api/oulu_1hr_latest.json");
      if (res2.ok) {
        const j = await res2.json();
        const count = parseFloat(j?.count || j?.value || 0);
        if (count > 0) {
          return {
            feed: "cosmic_ray_nmdb",
            stats: {
              latest_count: count,
              station: "OULU — Finland (60°N)",
              status: "NOMINAL — live count received",
              gpdm_note: "Cosmic ray flux — heliospheric modulation proxy for The Traveling System framework"
            },
            anomalies: []
          };
        }
      }
    } catch(e2) {}
    return null;
  }
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const { db } = await import('../firebase.js');

    // Get last pull timestamp
    const stateRef = db.collection('system_state').doc('pull_tracker');
    const stateDoc = await stateRef.get();
    const lastPull = stateDoc.exists ? stateDoc.data().last_pull : null;

    // Fetch all feeds in parallel — new feeds added
    const [kp, seismic, solar, solarWind, f107, goesXray, schumann, ionosphere, omni, dst, cosmicRay] = await Promise.all([
      fetchKp(lastPull),
      fetchSeismic(lastPull),
      fetchSolar(lastPull),
      fetchSolarWind(),
      fetchF107(),
      fetchGoesXray(),
      fetchSchumann(),
      fetchIonosphere(),
      fetchOMNI(),
      fetchDst(),
      fetchCosmicRay()
    ]);

    const feeds = [kp, seismic, solar, solarWind, f107, goesXray, schumann, ionosphere, omni, dst, cosmicRay].filter(Boolean);
    const cross = analyzeCrossChannel(feeds);

    // Build stats object for Firestore
    const feedStats = {};
    feeds.forEach(f => { if (f) feedStats[f.feed] = f.stats; });

    const allAnomalies = feeds.flatMap(f => f?.anomalies || []);
    const totalAnomalies = allAnomalies.length;

    const overallStatus = cross.multi_channel
      ? (cross.flags.some(f => f.includes('PLANETARY CHAIN')) ? "GPDM PLANETARY CHAIN ACTIVE"
        : cross.flags.some(f => f.includes('CME CHAIN')) ? "GPDM CME CHAIN ACTIVE"
        : "MULTI-CHANNEL ANOMALY DETECTED")
      : totalAnomalies > 0 ? "ANOMALIES DETECTED"
      : "BASELINE NORMAL";

    const now = new Date().toISOString();
    const dateStr = now.split('T')[0];

    const caseDoc = {
      case_type: "daily_anomaly_report",
      date: dateStr,
      pull_window: { from: lastPull || new Date(Date.now() - 86400000).toISOString(), to: now },
      summary: {
        overall_status: overallStatus,
        total_anomalies: totalAnomalies,
        feeds_active: feeds.length,
        multi_channel: cross.multi_channel,
        gpdm_chain_flags: cross.flags
      },
      feed_stats: feedStats,
      anomalies: allAnomalies,
      created_at: now
    };

    // Write to Firestore
    await db.collection('daily_reports').add(caseDoc);

    // Update pull tracker
    await stateRef.set({ last_pull: now });

    // Write map pins for located anomalies
    const locatedAnomalies = allAnomalies.filter(a => a.lat && a.lng);
    if (locatedAnomalies.length > 0) {
      const pinsBatch = db.batch();
      locatedAnomalies.forEach(a => {
        const ref = db.collection('map_pins').doc();
        pinsBatch.set(ref, { ...a, date: dateStr, created_at: now });
      });
      await pinsBatch.commit();
    }

    res.status(200).json({
      success: true,
      date: dateStr,
      feeds_captured: feeds.length,
      total_anomalies: totalAnomalies,
      status: overallStatus,
      new_feeds: ['dst_index', 'cosmic_ray_nmdb'],
      gpdm_flags: cross.flags
    });

  } catch (err) {
    console.error('Anomaly handler error:', err);
    res.status(500).json({ error: 'Handler failed', details: err.message });
  }
}
