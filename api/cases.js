import { db } from "../firebase.js";

export default async function handler(req, res) {
  try {
    const { limit = 10, date } = req.query;

    let query = db.collection("daily_reports")
      .where("case_type", "==", "daily_anomaly_report")
      .orderBy("date", "desc")
      .limit(parseInt(limit));

    // Filter to specific date if requested
    if (date) {
      query = db.collection("daily_reports")
        .where("case_type", "==", "daily_anomaly_report")
        .where("date", "==", date);
    }

    const snapshot = await query.get();
    const cases = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.status(200).json({
      total: cases.length,
      cases
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to load cases", details: err.message });
  }
}
