export default async function handler(req, res) {
  res.status(200).json({
    status: "API is working",
    message: "Vercel function detected"
  });
}
