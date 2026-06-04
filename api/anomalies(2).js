// anomalies.js — Presignal Anomaly Dashboard v2.5
// Fixes: Kp→GFZ Potsdam, Google Sheets write restored, seismic suppression watch,
//        GPDM chain flag (strict 4-condition), quiet-day zero returns
// John Ernest Carter | Presignal Inc. | June 2026

// ─────────────────────────────────────────────
// GOOGLE SHEETS WRITE — primary data pipeline
// Apps Script endpoint receives POST with row array
// CRITICAL: Every edit to Apps Script needs redeploy as NEW VERSION
//           Deploy → Manage deployments → Edit → New version → Deploy
// ─────────────────────────────────────────────

const SHEETS_URL = process.env.SHEETS_ENDPOINT ||
  "https://script.google.com/macros/s/AKfycbzCRV599wN-OzdRRLAyUJi4cOOEInCBF3O49SPKWiE/exec";

async function writeToSheets(row) {
  // row is an array matching the schema columns A→AE
  // Wrap in try/catch so a Sheets failure never kills the cron
  // NOTE: Apps Script /exec redirects before serving — must use GET with encoded
  // payload, or POST with redirect:'follow'. Using GET+params is more reliable
  // from serverless environments where POST redirect chains often hit auth walls.
  try {
    const payload = encodeURIComponent(JSON.stringify({ row }));
    const url = `${SHEETS_URL}?data=${payload}`;

    const res = await fetch(url, {
      method: "GET",
      redirect: "follow"
    });

    // Apps Script /exec always returns 200 even on script errors
    // The response body tells us what actually happened
    const text = await res.text();

    if (!res.ok) {
      console.error(`[SHEETS] HTTP error ${res.status}: ${text}`);
      return { success: false, error: `HTTP ${res.status}`, body: text };
    }

    // Log the full response for debugging — surfaced in Vercel function logs
    console.log(`[SHEETS] Write response (status ${res.status}): ${text}`);

    // Apps Script returns JSON with a "result" field on success
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      // Non-JSON response — log it and treat as success if status was 200
      console.warn(`[SHEETS] Non-JSON response: ${text}`);
      return { success: true, raw: text };
    }

    if (parsed.status === "error" || parsed.error) {
      console.error(`[SHEETS] Apps Script error: ${JSON.stringify(parsed)}`);
      return { success: false, error: parsed.error || parsed.message, details: parsed };
    }

    return { success: true, result: parsed };

  } catch (e) {
    // Network-level failure — log full error
    console.error(`[SHEETS] Network/fetch error: ${e.message}`, e);
    return { success: false, error: e.message };
  }
}

// Build the row array for Google Sheets from the collected feed data
// Columns A→AE as per the schema in HANDOFF_dashboard_fix_2026-06-04.md
function buildSheetsRow(dateStr, now, feedStats, cross, allAnomalies, overallStatus) {
  const kp    = feedStats.kp_geomagnetic      || {};
  const dst   = feedStats.dst_index           || {};
  const sw    = feedStats.solar_wind          || {};
  const f107  = feedStats.f107_solar_flux     || {};
  const goes  = feedStats.goes_xray           || {};
  const donki = feedStats.donki_solar         || {};
  const cr    = feedStats.cosmic_ray_nmdb     || {};
  const tec   = feedStats.ionosphere_tec      || {};
  const seis  = feedStats.usgs_seismic        || {};

  // Column mapping (A=0 ... AE=30)
  return [
    dateStr,                                                      // A  Date (UTC)
    now,                                                          // B  Pull timestamp
    kp.peak_kp            ?? 0,                                   // C  Kp peak
    kp.average_kp         ?? 0,                                   // D  Kp average
    kp.storm_level_readings ?? 0,                                 // E  Storm readings (Kp≥5)
    kp.status             ?? "QUIET",                             // F  Kp status
    dst.dst_min_24h_nT    ?? 0,                                   // G  Dst min nT
    sw.speed_kms          ?? 0,                                   // H  Solar wind speed km/s
    sw.density_pcm3       ?? 0,                                   // I  Solar wind density
    sw.bt_nT              ?? 0,                                   // J  Bt nT
    sw.bz_nT              ?? 0,                                   // K  Bz nT
    sw.geoeffective       ?? false,                               // L  Geoeffective
    f107.flux_sfu         ?? 0,                                   // M  F10.7 flux
    goes.current_class    ?? "B",                                 // N  GOES current class
    goes.peak_class_24h   ?? "B",                                 // O  GOES peak 24h
    donki.m_class_flares  ?? 0,                                   // P  M-class flares
    donki.x_class_flares  ?? 0,                                   // Q  X-class flares
    donki.cmes_detected   ?? 0,                                   // R  CMEs total
    donki.earth_directed_cmes ?? 0,                               // S  Earth-directed CMEs
    cr.latest_count       ?? 0,                                   // T  Cosmic ray flux (Oulu)
    tec.tec_disturbance   ?? false,                               // U  TEC disturbance
    seis.total_events     ?? 0,                                   // V  Seismic events total
    seis.above_m3         ?? 0,                                   // W  Above M3.0
    seis.above_m5         ?? 0,                                   // X  Above M5.0
    seis.above_m6         ?? 0,                                   // Y  Above M6.0
    seis.peak_magnitude   ?? 0,                                   // Z  Peak magnitude
    allAnomalies.length,                                          // AA Anomaly count
    cross.multi_channel   ?? false,                               // AB Multi-channel flag
    cross.gpdm_chain_flag ?? false,                               // AC GPDM chain flag
    overallStatus,                                                // AD Overall status
    cross.flags?.join(" | ") ?? ""                                // AE Notes
  ];
}

// ─────────────────────────────────────────────
// SEISMIC SUPPRESSION WATCH
// Tracks 48–120h post-storm seismic release windows
// Based on June 4 2026 analysis: 28.4-sigma storm suppression finding
// Baseline: 1.32 M5.5+ events/day globally
// ─────────────────────────────────────────────

async function checkSeismicSuppressionWatch(db, kpStats, seismicStats, now) {
  const watchRef = db.collection('system_state').doc('seismic_suppression_watch');
  const watchDoc = await watchRef.get();
  const watchData = watchDoc.exists ? watchDoc.data() : null;

  const M55_BASELINE = 1.32; // events/day globally (from June 4 analysis)
  const nowMs = new Date(now).getTime();

  // Check if a storm is currently active
  const stormOnset = (kpStats?.peak_kp ?? 0) >= 5;

  let watchStatus = null;
  let watchNote = null;

  if (stormOnset && (!watchData || !watchData.storm_active)) {
    // New storm onset — start the watch window
    const onsetTime = now;
    await watchRef.set({
      storm_active: true,
      storm_onset: onsetTime,
      window_opens: new Date(nowMs + 48 * 3600000).toISOString(),   // +48h
      window_closes: new Date(nowMs + 120 * 3600000).toISOString(), // +120h
      m55_events_in_window: 0,
      pulls_in_window: 0,
      last_updated: now
    });
    watchStatus = "STORM ONSET LOGGED — suppression window started";
    watchNote = `Storm onset at ${onsetTime}. Kp peak: ${kpStats.peak_kp}. Watch window: +48h to +120h. Expected seismic suppression during storm, elevated release after.`;
    console.log(`[SUPPRESSION WATCH] Storm onset logged: Kp ${kpStats.peak_kp} at ${onsetTime}`);

  } else if (watchData?.storm_active) {
    const windowOpens = new Date(watchData.window_opens).getTime();
    const windowCloses = new Date(watchData.window_closes).getTime();

    if (nowMs >= windowOpens && nowMs <= windowCloses) {
      // Inside the 48–120h release window — count M5.5+ events
      const m55Count = seismicStats?.above_m5 ?? 0; // using M5.0+ as closest proxy
      const newTotal = (watchData.m55_events_in_window ?? 0) + m55Count;
      const newPulls = (watchData.pulls_in_window ?? 0) + 1;

      await watchRef.update({
        m55_events_in_window: newTotal,
        pulls_in_window: newPulls,
        last_updated: now
      });

      const rate = newPulls > 0 ? (newTotal / newPulls).toFixed(2) : 0;
      const vsBaseline = (rate / M55_BASELINE).toFixed(2);

      watchStatus = "STORM SUPPRESSION WINDOW — elevated seismic release expected +48h to +120h";
      watchNote = `Window open. M5.0+ events this pull: ${m55Count}. Window total: ${newTotal} over ${newPulls} pulls. Rate: ${rate}/pull vs baseline ${M55_BASELINE}/day. Ratio vs baseline: ${vsBaseline}x`;
      console.log(`[SUPPRESSION WATCH] ${watchStatus} | ${watchNote}`);

    } else if (nowMs > windowCloses) {
      // Window closed — log final result and clear watch
      const rate = watchData.pulls_in_window > 0
        ? (watchData.m55_events_in_window / watchData.pulls_in_window).toFixed(2)
        : 0;
      const vsBaseline = (rate / M55_BASELINE).toFixed(2);

      const result = parseFloat(vsBaseline) > 1.5 ? "ELEVATED — seismic release confirmed"
                   : parseFloat(vsBaseline) < 0.7 ? "SUPPRESSED — below baseline"
                   : "BASELINE — within normal range";

      // Archive to Firestore for analysis
      await db.collection('suppression_windows').add({
        storm_onset: watchData.storm_onset,
        window_opens: watchData.window_opens,
        window_closes: watchData.window_closes,
        m55_events_total: watchData.m55_events_in_window,
        pulls_in_window: watchData.pulls_in_window,
        rate_per_pull: parseFloat(rate),
        vs_baseline: parseFloat(vsBaseline),
        result,
        closed_at: now
      });

      // Clear the active watch
      await watchRef.set({ storm_active: false, last_cleared: now });

      watchStatus = `SUPPRESSION WINDOW CLOSED — ${result}`;
      watchNote = `Final: ${watchData.m55_events_in_window} M5.0+ events in window. Rate ${rate}/pull vs baseline ${M55_BASELINE}/day. ${result}`;
      console.log(`[SUPPRESSION WATCH] Window closed. ${watchNote}`);

    } else if (nowMs < windowOpens && !stormOnset) {
      // In the suppression phase (0–48h) — storm has passed but window not open yet
      watchStatus = "STORM SUPPRESSION PHASE — seismic release window opens in <48h";
      watchNote = `Storm onset: ${watchData.storm_onset}. Release window opens: ${watchData.window_opens}`;
    }
  }

  return { watchStatus, watchNote };
}

// ─────────────────────────────────────────────
// DATA FETCHERS — ORIGINAL THREE (FIXED)
// ─────────────────────────────────────────────

// BUG 1 FIX: Switched from NOAA K-index to GFZ Potsdam endpoint
// GFZ returns {"datetime":[...], "Kp":[...]} — handles null as 0
// Always writes a row even on quiet days (zero-value return)
async function fetchKp() {
  const dateStr = new Date().toISOString().split("T")[0];
  const url = `https://kp.gfz-potsdam.de/app/json/?start=${dateStr}T00:00:00Z&end=${dateStr}T23:59:59Z&index=Kp&status=def&missing=fill&idxsep=false`;

  const QUIET_RETURN = {
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

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[KP] GFZ fetch failed: HTTP ${res.status}`);
      return QUIET_RETURN;
    }

    const raw = await res.json();

    const datetimes = raw.datetime || [];
    const kpValues  = raw.Kp       || [];

    if (datetimes.length === 0 || kpValues.length === 0) {
      console.warn(`[KP] GFZ returned empty arrays — treating as quiet day`);
      return QUIET_RETURN;
    }

    // BUG 3 FIX: treat null Kp as 0, never drop a reading
    const readings = datetimes.map((t, i) => ({
      time: t,
      kp: kpValues[i] === null || kpValues[i] === undefined ? 0 : parseFloat(kpValues[i])
    })).filter(r => !isNaN(r.kp));

    // If all readings are fill values (all zero from null), still return QUIET
    const allZero = readings.every(r => r.kp === 0);
    if (allZero) {
      console.log(`[KP] All null/zero fill values from GFZ — quiet day`);
      return { ...QUIET_RETURN, stats: { ...QUIET_RETURN.stats, readings_captured: readings.length } };
    }

    const values = readings.map(r => r.kp);
    const peak = Math.max(...values);
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    const stormReadings = readings.filter(r => r.kp >= 5);
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

    console.log(`[KP] GFZ OK — ${readings.length} readings, peak Kp ${peak}, ${stormReadings.length} storm readings`);

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

  } catch (e) {
    console.error(`[KP] fetchKp error: ${e.message}`);
    return QUIET_RETURN;
  }
}

async function fetchSeismic(since) {
  const sinceTime = since
    ? new Date(since).toISOString()
    : new Date(Date.now() - 86400000).toISOString();

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${sinceTime}&minmagnitude=2.5&orderby=magnitude`;

  // BUG 3 FIX: always return zero-value object, never null
  const QUIET_RETURN = {
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

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[SEISMIC] USGS fetch failed: HTTP ${res.status}`);
      return QUIET_RETURN;
    }

    const raw = await res.json();
    const events = raw.features || [];

    if (events.length === 0) return QUIET_RETURN;

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
  } catch (e) {
    console.error(`[SEISMIC] fetchSeismic error: ${e.message}`);
    return QUIET_RETURN;
  }
}

async function fetchSolar(since) {
  const sinceDate = since
    ? new Date(since).toISOString().split("T")[0]
    : new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  const QUIET_RETURN = {
    feed: "donki_solar",
    stats: {
      total_flares: 0,
      m_class_flares: 0,
      x_class_flares: 0,
      cmes_detected: 0,
      earth_directed_cmes: 0,
      status: "QUIET"
    },
    anomalies: []
  };

  try {
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
  } catch (e) {
    console.error(`[SOLAR] fetchSolar error: ${e.message}`);
    return QUIET_RETURN;
  }
}

// ─────────────────────────────────────────────
// DATA FETCHERS — NEW FEEDS (v2.4 GPDM)
// ─────────────────────────────────────────────

// NOAA DSCOVR real-time solar wind
async function fetchSolarWind() {
  try {
    const [magRes, plasmaRes] = await Promise.all([
      fetch("https://services.swpc.noaa.gov/products/solar-wind/mag-7-day.json"),
      fetch("https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json")
    ]);

    const magRaw    = await magRes.json();
    const plasmaRaw = await plasmaRes.json();

    const recentMag    = magRaw.slice(-24);
    const recentPlasma = plasmaRaw.slice(-24);

    const latestMag    = recentMag[recentMag.length - 1];
    const latestPlasma = recentPlasma[recentPlasma.length - 1];

    const bt      = parseFloat(latestMag[6]);
    const bz      = parseFloat(latestMag[3]);
    const speed   = parseFloat(latestPlasma[2]);
    const density = parseFloat(latestPlasma[1]);

    const isElevated     = speed > 500 || density > 15 || bz < -10;
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
        speed_kms:    parseFloat(speed.toFixed(1)),
        density_pcm3: parseFloat(density.toFixed(2)),
        bt_nT:        parseFloat(bt.toFixed(2)),
        bz_nT:        parseFloat(bz.toFixed(2)),
        geoeffective: bz < -5,
        status: isStormWarning ? "STORM WARNING — Kp spike likely 30-60 min"
               : isElevated    ? "ELEVATED — monitor Kp"
               : "NOMINAL"
      },
      anomalies
    };
  } catch (e) {
    console.error(`[SOLAR_WIND] fetchSolarWind error: ${e.message}`);
    return {
      feed: "solar_wind",
      stats: { speed_kms: 0, density_pcm3: 0, bt_nT: 0, bz_nT: 0, geoeffective: false, status: "NO DATA" },
      anomalies: []
    };
  }
}

// NOAA F10.7 Solar Flux
async function fetchF107() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/products/summary/10cm-flux.json");
    const raw = await res.json();

    const flux       = parseFloat(raw.Flux);
    const isElevated = flux > 150;
    const isHigh     = flux > 200;

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
        status: isHigh ? "HIGH SOLAR ACTIVITY" : isElevated ? "ELEVATED SOLAR ACTIVITY" : "NORMAL",
        gpdm_note: "F10.7 > 150 correlates with elevated geological discharge probability at GPDM sites"
      },
      anomalies
    };
  } catch (e) {
    console.error(`[F107] fetchF107 error: ${e.message}`);
    return { feed: "f107_solar_flux", stats: { flux_sfu: 0, status: "NO DATA" }, anomalies: [] };
  }
}

// GOES X-ray Flux
async function fetchGoesXray() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json");
    const raw = await res.json();

    if (!raw || raw.length === 0) return { feed: "goes_xray", stats: { current_class: "B", peak_class_24h: "B", status: "NO DATA" }, anomalies: [] };

    const recent   = raw.slice(-30);
    const latest   = recent[recent.length - 1];
    const flux     = parseFloat(latest.flux);
    const time     = latest.time_tag;

    const getClass = (f) => {
      if (f >= 1e-4) return "X";
      if (f >= 1e-5) return "M";
      if (f >= 1e-6) return "C";
      return "B";
    };

    const flareClass = getClass(flux);
    const isMOrHigher = flux >= 1e-5;
    const isXClass    = flux >= 1e-4;
    const peakFlux    = Math.max(...recent.map(r => parseFloat(r.flux)));
    const peakClass   = getClass(peakFlux);

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
    console.error(`[GOES] fetchGoesXray error: ${e.message}`);
    return { feed: "goes_xray", stats: { current_class: "B", peak_class_24h: "B", status: "NO DATA" }, anomalies: [] };
  }
}

// Schumann Resonance proxy via Dst
async function fetchSchumann() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/products/kyoto-dst.json");
    const raw = await res.json();

    const rows   = raw.slice(1);
    const recent = rows.slice(-12);
    const values = recent.map(r => parseFloat(r[1])).filter(v => !isNaN(v));

    if (values.length === 0) return { feed: "schumann_proxy", stats: { dst_nT: 0, min_dst_12h: 0, sr_disturbance_likely: false, status: "NO DATA" }, anomalies: [] };

    const latestDst = values[values.length - 1];
    const minDst    = Math.min(...values);
    const isElevated = minDst < -30;
    const isMajor    = minDst < -100;

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
        status: isMajor    ? "MAJOR SR DISTURBANCE — 3rd/4th mode anomaly likely"
               : isElevated ? "ELEVATED — SR amplitude above baseline"
               : "NOMINAL",
        gpdm_note: "GPDM predicts Schumann 3rd/4th mode anomaly 1-7 days before discharge events. Dst proxy used pending direct SR feed integration."
      },
      anomalies
    };
  } catch (e) {
    console.error(`[SCHUMANN] fetchSchumann error: ${e.message}`);
    return { feed: "schumann_proxy", stats: { dst_nT: 0, min_dst_12h: 0, sr_disturbance_likely: false, status: "NO DATA" }, anomalies: [] };
  }
}

// Ionospheric TEC proxy
async function fetchIonosphere() {
  try {
    const res = await fetch("https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json");
    const raw = await res.json();

    const bz = parseFloat(raw.Bz);
    const bt = parseFloat(raw.Bt);

    const isTECElevated = bz < -10 && bt > 10;
    const isTECMajor    = bz < -20;

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
        status: isTECMajor    ? "MAJOR TEC DISTURBANCE — GPS degradation expected"
               : isTECElevated ? "TEC ELEVATED — monitor GPS SNR"
               : "NOMINAL",
        gpdm_note: "TEC anomalies 1-15 days before M6+ events documented by Hayakawa et al."
      },
      anomalies
    };
  } catch (e) {
    console.error(`[TEC] fetchIonosphere error: ${e.message}`);
    return { feed: "ionosphere_tec", stats: { bz_nT: 0, bt_nT: 0, tec_disturbance: false, status: "NO DATA" }, anomalies: [] };
  }
}

// NASA OMNI multi-variable solar wind historical
async function fetchOMNI() {
  try {
    const now       = new Date();
    const yesterday = new Date(now - 86400000);
    const startDate = yesterday.toISOString().slice(0,10).replace(/-/g,'');
    const endDate   = now.toISOString().slice(0,10).replace(/-/g,'');

    const params = new URLSearchParams({
      activity: 'retrieve', res: 'hour', spacecraft: 'omni2',
      start_date: startDate, end_date: endDate, table: '1', view: '0'
    });
    ['8','13','23','24','40','38','50'].forEach(v => params.append('vars', v));

    const res  = await fetch('https://omniweb.gsfc.nasa.gov/cgi/nx1.cgi', { method: 'POST', body: params });
    const text = await res.text();
    const lines = text.split('\n').filter(l => /^\s*\d{4}\s+\d+/.test(l));

    if (lines.length === 0) return { feed: "omni_solar_wind", stats: { status: "NO DATA", active_conditions: 0 }, anomalies: [] };

    const readings = lines.map(line => {
      const p = line.trim().split(/\s+/);
      return { bt: parseFloat(p[3]), bz: parseFloat(p[4]), speed: parseFloat(p[5]), density: parseFloat(p[6]), kp: parseFloat(p[7]) / 10, f107: parseFloat(p[8]), dst: parseFloat(p[9]) };
    }).filter(r => r.speed < 9000 && r.bt < 9000 && r.bz < 9000 && r.density < 9000);

    if (readings.length === 0) return { feed: "omni_solar_wind", stats: { status: "NO DATA", active_conditions: 0 }, anomalies: [] };

    const avgSpeed    = readings.reduce((a,b) => a + b.speed, 0) / readings.length;
    const minBz       = Math.min(...readings.map(r => r.bz));
    const maxDensity  = Math.max(...readings.map(r => r.density));
    const dstValues   = readings.map(r => r.dst).filter(d => d > -9000);
    const minDst      = dstValues.length > 0 ? Math.min(...dstValues) : null;
    const latestF107  = readings.filter(r => r.f107 < 9000).pop()?.f107 || null;

    const activeConditions = [
      avgSpeed > 500    && 'elevated solar wind speed',
      minBz < -10       && 'southward Bz geoeffective',
      maxDensity > 15   && 'high proton density',
      minDst !== null && minDst < -30 && 'geomagnetic disturbance (Dst suppressed)',
      latestF107 && latestF107 > 150 && 'elevated solar flux'
    ].filter(Boolean);

    return {
      feed: "omni_solar_wind",
      stats: {
        avg_speed_kms: parseFloat(avgSpeed.toFixed(1)),
        min_bz_nT:     parseFloat(minBz.toFixed(2)),
        max_density:   parseFloat(maxDensity.toFixed(2)),
        min_dst_nT:    minDst,
        f107_sfu:      latestF107,
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
    console.error(`[OMNI] fetchOMNI error: ${e.message}`);
    return { feed: "omni_solar_wind", stats: { status: "NO DATA", active_conditions: 0 }, anomalies: [] };
  }
}

// Real Dst index — Kyoto World Data Centre via NOAA
async function fetchDst() {
  try {
    const res  = await fetch("https://services.swpc.noaa.gov/products/kyoto-dst.json");
    const raw  = await res.json();
    const rows = raw.slice(1);

    const recent = rows.slice(-24);
    const values = recent.map(r => parseFloat(r[1])).filter(v => !isNaN(v) && v > -9999);

    if (values.length === 0) return { feed: "dst_index", stats: { dst_latest_nT: 0, dst_min_24h_nT: 0, dst_avg_24h_nT: 0, storm_level: "QUIET", ring_current_active: false, status: "NO DATA" }, anomalies: [] };

    const latestDst = values[values.length - 1];
    const minDst    = Math.min(...values);
    const avgDst    = parseFloat((values.reduce((a,b) => a+b, 0) / values.length).toFixed(1));

    const getStormLevel = (d) => {
      if (d > -20)  return "QUIET";
      if (d > -50)  return "MINOR STORM";
      if (d > -100) return "MODERATE STORM";
      if (d > -200) return "INTENSE STORM";
      return "SUPER STORM";
    };

    const stormLevel  = getStormLevel(minDst);
    const isElevated  = minDst < -30;
    const isStorm     = minDst < -50;

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
        dst_latest_nT:   latestDst,
        dst_min_24h_nT:  minDst,
        dst_avg_24h_nT:  avgDst,
        storm_level:     stormLevel,
        ring_current_active: isElevated,
        status: stormLevel,
        gpdm_note: "Dst suppression below -50 nT indicates ring current injection — GPDM V3 atmospheric state disturbance."
      },
      anomalies
    };
  } catch (e) {
    console.error(`[DST] fetchDst error: ${e.message}`);
    return { feed: "dst_index", stats: { dst_latest_nT: 0, dst_min_24h_nT: 0, dst_avg_24h_nT: 0, storm_level: "QUIET", ring_current_active: false, status: "NO DATA" }, anomalies: [] };
  }
}

// NMDB Oulu Neutron Monitor — cosmic ray flux
async function fetchCosmicRay() {
  const QUIET_RETURN = {
    feed: "cosmic_ray_nmdb",
    stats: { latest_count: 0, avg_count_24h: 0, pct_from_mean: 0, forbush_decrease: false, station: "OULU — Finland (60°N)", status: "NO DATA" },
    anomalies: []
  };

  try {
    const now       = new Date();
    const yesterday = new Date(now - 86400000);
    const fmt = d => d.toISOString().slice(0,16).replace('T',' ');

    const url = `https://www.nmdb.eu/nest/draw_graph.php?formchk=1&stations[]=OULU&tabchoice=1hr&dtype=corr_for_efficiency&tresolution=60&force=1&s_date1=${fmt(yesterday)}&s_time1=00:00&s_date2=${fmt(now)}&s_time2=23:59&output=ascii`;

    const res  = await fetch(url, { headers: { 'User-Agent': 'Presignal-AnomalyDashboard/2.0 (jubecrew@gmail.com)' } });
    const text = await res.text();

    const lines = text.split('\n').filter(l => /^\d{4}-\d{2}-\d{2}/.test(l.trim()));
    if (lines.length === 0) return QUIET_RETURN;

    const readings = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      return { time: `${parts[0]}T${parts[1]}Z`, count: parseFloat(parts[2]) };
    }).filter(r => !isNaN(r.count) && r.count > 0);

    if (readings.length === 0) return QUIET_RETURN;

    const counts     = readings.map(r => r.count);
    const latest     = counts[counts.length - 1];
    const avg        = counts.reduce((a,b) => a+b, 0) / counts.length;
    const min        = Math.min(...counts);
    const pctFromMean = parseFloat(((latest - avg) / avg * 100).toFixed(2));
    const minPctDrop  = parseFloat(((min - avg) / avg * 100).toFixed(2));
    const isForbush   = minPctDrop < -3;
    const isAnomaly   = Math.abs(pctFromMean) > 1;

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
        latest_count:     parseFloat(latest.toFixed(1)),
        avg_count_24h:    parseFloat(avg.toFixed(1)),
        pct_from_mean:    pctFromMean,
        min_pct_drop_24h: minPctDrop,
        forbush_decrease: isForbush,
        station: "OULU — Finland (60°N)",
        status: isForbush  ? "FORBUSH DECREASE — solar modulation active"
               : isAnomaly ? "ANOMALY — cosmic ray flux deviation detected"
               : "NOMINAL — galactic cosmic ray baseline stable",
        gpdm_note: "Cosmic ray flux connects The Traveling System (heliospheric modulation of GCR) to GPDM Variable 1."
      },
      anomalies
    };
  } catch (e) {
    console.error(`[COSMIC] fetchCosmicRay error: ${e.message}`);
    return QUIET_RETURN;
  }
}

// ─────────────────────────────────────────────
// CROSS-CHANNEL ANALYSIS — with strict GPDM chain flag
// GPDM chain requires ALL FOUR conditions simultaneously:
//   1. Solar wind speed > 450 km/s OR Kp >= 5
//   2. At least 1 M-class flare in 24h
//   3. At least 1 M5.0+ earthquake in 24h
//   4. Bz negative (southward, geoeffective)
// ─────────────────────────────────────────────

function analyzeCrossChannel(feeds) {
  const activeFeeds  = feeds.filter(f => f && f.anomalies.length > 0);
  const isMultiChannel = activeFeeds.length >= 2;
  const flags = [];

  if (isMultiChannel) {
    flags.push(`Multi-channel event: ${activeFeeds.map(f => f.feed).join(" + ")}`);
  }

  // Pull stats for GPDM chain evaluation
  const kpStats   = feeds.find(f => f?.feed === "kp_geomagnetic")?.stats    || {};
  const swStats   = feeds.find(f => f?.feed === "solar_wind")?.stats        || {};
  const donkiStats = feeds.find(f => f?.feed === "donki_solar")?.stats      || {};
  const seisStats  = feeds.find(f => f?.feed === "usgs_seismic")?.stats     || {};

  // Strict 4-condition GPDM chain flag
  const cond1 = (swStats.speed_kms || 0) > 450 || (kpStats.peak_kp || 0) >= 5;
  const cond2 = (donkiStats.m_class_flares || 0) >= 1 || (donkiStats.x_class_flares || 0) >= 1;
  const cond3 = (seisStats.above_m5 || 0) >= 1;
  const cond4 = (swStats.bz_nT || 0) < 0;    // southward Bz = geoeffective

  const gpdmChainFlag = cond1 && cond2 && cond3 && cond4;

  if (gpdmChainFlag) {
    flags.push(`GPDM CHAIN EVENT: All 4 conditions met — SW speed/Kp=${cond1}, M-flare=${cond2}, M5+seismic=${cond3}, Bz-southward=${cond4}. Log to Firestore and Sheets.`);
  }

  // Additional correlation flags
  const hasSolar    = activeFeeds.find(f => f.feed === "donki_solar");
  const hasKp       = activeFeeds.find(f => f.feed === "kp_geomagnetic");
  const hasSolarWind = activeFeeds.find(f => f.feed === "solar_wind");
  const hasGoesXray  = activeFeeds.find(f => f.feed === "goes_xray");
  const hasSchumann  = activeFeeds.find(f => f.feed === "schumann_proxy");
  const hasSeismic   = activeFeeds.find(f => f.feed === "usgs_seismic");
  const hasTEC       = activeFeeds.find(f => f.feed === "ionosphere_tec");

  if (hasSolar && hasKp) flags.push("Solar activity correlating with geomagnetic disturbance — causal chain possible");
  if (hasSolarWind && hasKp) flags.push("GPDM V1 CASCADE: Solar wind elevated correlating with Kp — geological discharge window open at active sites");
  if (hasSolar && hasSolarWind && hasKp) flags.push("GPDM CME CHAIN: Flare → solar wind → geomagnetic disturbance — complete Variable 1 chain active");
  if (hasTEC && hasSeismic) flags.push("GPDM PRECURSOR: Ionospheric disturbance correlating with seismic activity — TEC pre-seismic window possible");
  if (hasSchumann && hasKp) flags.push("GPDM PREDICTION CHANNEL: Schumann disturbance + geomagnetic storm — monitor for 1-7 day discharge window");
  if (hasGoesXray && hasTEC) flags.push("Solar flare driving ionospheric TEC disturbance — GPS SNR degradation expected at field nodes");

  const chainFeeds = [hasGoesXray, hasSolarWind, hasKp, hasTEC, hasSchumann].filter(Boolean);
  if (chainFeeds.length >= 4) flags.push("GPDM PLANETARY CHAIN: Multiple layers of the Sun-to-ground circuit active simultaneously");

  return {
    multi_channel:   isMultiChannel,
    active_feed_count: activeFeeds.length,
    gpdm_chain_flag: gpdmChainFlag,
    gpdm_chain_conditions: { cond1_sw_or_kp: cond1, cond2_m_flare: cond2, cond3_m5_seismic: cond3, cond4_bz_south: cond4 },
    flags
  };
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

    // Fetch all feeds in parallel
    const [kp, seismic, solar, solarWind, f107, goesXray, schumann, ionosphere, omni, dst, cosmicRay] = await Promise.all([
      fetchKp(),                // BUG 1 FIXED: GFZ Potsdam endpoint, no lastPull arg needed
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

    // BUG 3 FIX: All fetchers now return zero-value objects, never null
    // filter(Boolean) still used for any unexpected null
    const feeds = [kp, seismic, solar, solarWind, f107, goesXray, schumann, ionosphere, omni, dst, cosmicRay].filter(Boolean);
    const cross = analyzeCrossChannel(feeds);

    // Build stats object for Firestore
    const feedStats = {};
    feeds.forEach(f => { if (f) feedStats[f.feed] = f.stats; });

    const allAnomalies = feeds.flatMap(f => f?.anomalies || []);
    const totalAnomalies = allAnomalies.length;

    const overallStatus = cross.gpdm_chain_flag
      ? "GPDM CHAIN EVENT ACTIVE"
      : cross.multi_channel
        ? (cross.flags.some(f => f.includes('PLANETARY CHAIN')) ? "GPDM PLANETARY CHAIN ACTIVE"
          : cross.flags.some(f => f.includes('CME CHAIN')) ? "GPDM CME CHAIN ACTIVE"
          : "MULTI-CHANNEL ANOMALY DETECTED")
      : totalAnomalies > 0 ? "ANOMALIES DETECTED"
      : "BASELINE NORMAL";

    const now     = new Date().toISOString();
    const dateStr = now.split('T')[0];

    // ── Seismic suppression watch ──────────────────────────
    const { watchStatus, watchNote } = await checkSeismicSuppressionWatch(
      db,
      feedStats.kp_geomagnetic,
      feedStats.usgs_seismic,
      now
    );

    // Build Firestore document
    const caseDoc = {
      case_type: "daily_anomaly_report",
      date: dateStr,
      pull_window: { from: lastPull || new Date(Date.now() - 86400000).toISOString(), to: now },
      summary: {
        overall_status: overallStatus,
        total_anomalies: totalAnomalies,
        feeds_active: feeds.length,
        multi_channel: cross.multi_channel,
        gpdm_chain_flag: cross.gpdm_chain_flag,
        gpdm_chain_conditions: cross.gpdm_chain_conditions,
        gpdm_chain_flags: cross.flags,
        seismic_suppression_watch: watchStatus || null,
        seismic_suppression_note: watchNote || null
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

    // If GPDM chain event, log it separately for analysis
    if (cross.gpdm_chain_flag) {
      await db.collection('gpdm_chain_events').add({
        date: dateStr,
        timestamp: now,
        conditions: cross.gpdm_chain_conditions,
        kp_peak: feedStats.kp_geomagnetic?.peak_kp ?? 0,
        sw_speed: feedStats.solar_wind?.speed_kms ?? 0,
        bz: feedStats.solar_wind?.bz_nT ?? 0,
        m_flares: feedStats.donki_solar?.m_class_flares ?? 0,
        m5_seismic: feedStats.usgs_seismic?.above_m5 ?? 0,
        overall_status: overallStatus
      });
      console.log(`[GPDM CHAIN] Event logged to Firestore: ${dateStr}`);
    }

    // ── BUG 2 FIX: Write to Google Sheets with error logging ──────────
    const sheetsRow = buildSheetsRow(dateStr, now, feedStats, cross, allAnomalies, overallStatus);
    const sheetsResult = await writeToSheets(sheetsRow);

    if (!sheetsResult.success) {
      console.error(`[SHEETS] Daily write FAILED for ${dateStr}: ${sheetsResult.error}`);
      // Log failed write to Firestore so we can audit
      await db.collection('sheets_write_errors').add({
        date: dateStr,
        timestamp: now,
        error: sheetsResult.error,
        details: sheetsResult.details || null
      });
    } else {
      console.log(`[SHEETS] Daily write OK for ${dateStr}`);
    }

    res.status(200).json({
      success: true,
      date: dateStr,
      feeds_captured: feeds.length,
      total_anomalies: totalAnomalies,
      status: overallStatus,
      gpdm_chain: cross.gpdm_chain_flag,
      gpdm_chain_conditions: cross.gpdm_chain_conditions,
      gpdm_flags: cross.flags,
      seismic_suppression_watch: watchStatus || null,
      sheets_write: sheetsResult.success ? "OK" : `FAILED: ${sheetsResult.error}`,
      feeds: {
        kp:       { readings: feedStats.kp_geomagnetic?.readings_captured ?? 0, peak: feedStats.kp_geomagnetic?.peak_kp ?? 0, status: feedStats.kp_geomagnetic?.status },
        seismic:  { events: feedStats.usgs_seismic?.total_events ?? 0, peak_mag: feedStats.usgs_seismic?.peak_magnitude ?? 0 },
        solar:    { m_flares: feedStats.donki_solar?.m_class_flares ?? 0, x_flares: feedStats.donki_solar?.x_class_flares ?? 0 },
        solar_wind: { speed: feedStats.solar_wind?.speed_kms ?? 0, bz: feedStats.solar_wind?.bz_nT ?? 0 },
        dst:      { min_nT: feedStats.dst_index?.dst_min_24h_nT ?? 0, storm_level: feedStats.dst_index?.storm_level },
        cosmic_ray: { latest: feedStats.cosmic_ray_nmdb?.latest_count ?? 0, forbush: feedStats.cosmic_ray_nmdb?.forbush_decrease }
      }
    });

  } catch (err) {
    console.error('[HANDLER] Anomaly handler error:', err);
    res.status(500).json({ error: 'Handler failed', details: err.message });
  }
}
